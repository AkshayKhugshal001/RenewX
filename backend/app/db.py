"""PostgreSQL connection to Supabase (server-side only; bypasses RLS, so always check ownership first)."""
import psycopg

from . import config


def connect() -> psycopg.Connection:
    # prepare_threshold=None: Supabase's connection pooler does not support prepared statements.
    conn = psycopg.connect(config.database_url(), autocommit=True, prepare_threshold=None, connect_timeout=15)
    # Safety limits so one stuck request can never block others for long:
    #   lock_timeout   – give up (error) instead of waiting forever for a row another request has locked
    #   idle_in_transaction_session_timeout – the database ends a transaction left open by a dead/stuck request
    conn.execute("set lock_timeout = '30s'")
    conn.execute("set idle_in_transaction_session_timeout = '2min'")
    return conn
