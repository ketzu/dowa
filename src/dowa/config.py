from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DOWA_", env_file=".env", extra="ignore")

    interval_seconds: float = 5.0
    retention_days: int = 7
    db_path: Path = Path("/data/dowa.db")
    history_minutes_default: int = 30
    host: str = "0.0.0.0"
    port: int = 8000
    docker_base_url: str | None = None  # None -> use docker SDK defaults (env / unix socket)
    scraper_workers: int = 8
    log_level: str = "INFO"
    access_log: bool = True
    metrics_enabled: bool = True


settings = Settings()
