# 🇳🇬 Nigeria Conflict Early Warning System (CEWS)

> **Classification:** For Official Use Only  
> **Status:** Implementation-Ready v1.0 | October 2026  
> **Coverage:** 36 States + FCT · 774 LGAs · 6 Geopolitical Zones

---

## Project Structure

```
nigerian-cews/
├── database/
│   └── schema.sql              ← PostgreSQL 15 + PostGIS 3.4 full schema
├── backend/
│   ├── models/
│   │   └── database.py         ← SQLAlchemy 2.0 async ORM models
│   ├── services/
│   │   └── pii_handler.py      ← AES-256-GCM PII encryption service
│   ├── api/
│   │   └── v1/
│   │       └── ingest.py       ← FastAPI ingestion endpoints (web/USSD/SMS)
│   ├── tasks/
│   │   └── celery_app.py       ← Celery tasks + 5 priority queues
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── public/
│   │   └── sw.js               ← Workbox Service Worker (offline sync)
│   ├── lib/
│   │   ├── offline-vault.ts    ← IndexedDB report persistence
│   │   └── crypto.ts           ← WebCrypto ECDH key exchange + AES-GCM
│   ├── components/
│   │   ├── ReportForm.tsx      ← Progressive offline-capable report form
│   │   └── ZoneRiskMap.tsx     ← MapLibre GL JS choropleth dashboard
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml          ← Full service stack
├── CEWS_Nigeria_Blueprint.md   ← Master architectural blueprint (see artifacts)
└── README.md
```

---

## Quick Start (Development)

### Prerequisites
- Docker Desktop 4.x+
- Docker Compose v2.x
- 8GB RAM minimum (16GB recommended for full stack)

### 1. Clone and Configure

```bash
git clone <repo-url>
cd nigerian-cews

# Copy and fill environment variables
cp .env.example .env
```

### 2. `.env` Configuration

```env
# Database
POSTGRES_PASSWORD=<strong-random-password>

# PII Encryption (generate with: python -c "import secrets; print(secrets.token_hex(32))")
CEWS_PII_AES_KEY=<64-hex-chars>
CEWS_HMAC_SALT=<64-hex-chars>

# API Security
CEWS_WEBHOOK_SECRET=<strong-random-secret>

# Africa's Talking (obtain from africastalking.com)
AFRICAS_TALKING_API_KEY=<your-api-key>
AFRICAS_TALKING_USERNAME=<your-username>

# Keycloak
KEYCLOAK_ADMIN_PASSWORD=<strong-password>
KEYCLOAK_HOSTNAME=auth.cews.ng
KEYCLOAK_ISSUER_URL=https://auth.cews.ng/realms/cews
KEYCLOAK_CLIENT_ID=cews-web
KEYCLOAK_CLIENT_SECRET=<client-secret>
NEXTAUTH_SECRET=<strong-random-secret>

# Grafana
GRAFANA_ADMIN_PASSWORD=<strong-password>

# URLs (adjust for deployment)
API_BASE_URL=https://api.cews.ng
TILESERV_URL=https://tiles.cews.ng
```

### 3. Launch Services

```bash
# Start all services
docker compose up -d

# Check health
docker compose ps

# Apply database schema (runs automatically via initdb.d)
# Verify:
docker compose exec postgres psql -U cews_admin -d cews_db -c "\dt"
```

### 4. Access Services

| Service | URL | Credentials |
|---|---|---|
| Frontend Dashboard | http://localhost:3000 | Keycloak SSO |
| Backend API Docs | http://localhost:8000/docs | - |
| Tile Server | http://localhost:7800 | - |
| Keycloak Admin | http://localhost:8080 | .env KEYCLOAK_ADMIN_PASSWORD |
| Grafana | http://localhost:3001 | .env GRAFANA_ADMIN_PASSWORD |
| Prometheus | http://localhost:9090 | - |

---

## Architecture Summary

```
[Web Form / USSD *347*99# / SMS]
        │
   [API Gateway — Kong]
        │
   [FastAPI Ingestion Service]
   PII encrypted → reporter_pii_vault
   Payload queued → Redis Stream
        │
   [Celery Workers]
   process_report → dedup → spam_score → DB write
        │
   [PostgreSQL + PostGIS]
   conflict_alerts (GEOMETRY Point 4326)
   GiST indexes for proximity queries
        │
   [Human Verification — Peace Wardens]
   PENDING → UNDER_REVIEW → VERIFIED / FALSE_ALARM
        │
   [Analytics Layer]
   Zone risk scores → Redis cache → API
        │
   [Next.js PWA Dashboard]
   MapLibre GL choropleth + offline Service Worker
```

---

## USSD Reporting Flow

Reporters in remote LGAs (2G-only) can submit alerts via:
```
*347*99#
→ Press 1: Report Incident
→ Enter LGA Code (3 digits)
→ Select Incident Type (1-9)
→ Enter Casualty Count
→ Confirm
← "Report received. Ref: XXXXXX"
```

---

## Database Schema Key Tables

| Table | Purpose |
|---|---|
| `geo_zones` | 6 geopolitical zones |
| `geo_states` | 37 states + FCT |
| `geo_lgas` | 774 LGAs with PostGIS boundaries |
| `geo_wards` | ~8,809 wards |
| `app_users` | Multi-tenant RBAC (public_reporter / vetted_monitor / admin_analyst) |
| `reporter_pii_vault` | AES-256-GCM encrypted PII, isolated from alerts |
| `conflict_alerts` | Core alert table with `GEOMETRY(Point, 4326)` |
| `alert_verifications` | Immutable warden vote audit trail |
| `zone_risk_scores` | Precomputed 15-min zone risk cache |
| `geo_infrastructure_corridors` | Highway/pipeline corridors for proximity alerts |

---

## Security Architecture

- **Reporter PII**: AES-256-GCM encrypted at field level; linked to alerts only by opaque UUID token
- **PostgreSQL RLS**: `reporter_pii_vault` table restricted to `admin_analyst` role only
- **mTLS**: Peace Warden devices use client certificates for API authentication
- **HMAC-SHA256**: All webhook payloads signed and verified
- **Service Worker**: Offline report payloads encrypted client-side before IndexedDB storage
- **Spatial obfuscation**: Public dashboard snaps `watch`/`advisory` alert points to LGA centroids

---

## Compliance

This system is designed to comply with:
- Nigeria Data Protection Act 2023 (NDPA)
- NITDA Data Protection Regulation (NDPR) 2019
- AU Malabo Convention on Cyber Security
- GDPR (for diaspora-facing components)

---

## Contact & Governance

- **Technical Lead**: [CEWS Engineering Team]
- **Data Protection Officer**: [DPO Contact]
- **Funding Body**: [ECOWAS CEWS / UNDP / USIP]
- **Classification**: CONFIDENTIAL — FOR OFFICIAL USE ONLY
