"""
Nigeria CEWS — FastAPI Main Application Entrypoint
=================================================
Top-level entry point for production deployment (Uvicorn / Gunicorn).
Supports running both with root directory as `backend` or project root.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure backend directory is in sys.path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# Also allow parent directory in sys.path if nested
PARENT_DIR = BASE_DIR.parent
if str(PARENT_DIR) not in sys.path:
    sys.path.insert(0, str(PARENT_DIR))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import router
try:
    from api.v1.ingest import router as ingest_router
except ImportError:
    from backend.api.v1.ingest import router as ingest_router

app = FastAPI(
    title="Nigeria Conflict Early Warning System (CEWS) API",
    description="Decoupled, resilient ingestion and verification backend for nationwide conflict early warning.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust for production domains in settings
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(ingest_router)


@app.get("/health", tags=["Health"])
async def health_check():
    """Health check endpoint for Render / Kubernetes probes."""
    return {"status": "healthy", "service": "cews-backend", "version": "1.0.0"}


@app.get("/", tags=["Root"])
async def root():
    """Root redirect / information endpoint."""
    return {
        "message": "Nigeria CEWS API is online",
        "docs": "/docs",
        "health": "/health",
    }
