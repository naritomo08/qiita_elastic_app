import os
from pathlib import Path


RESULTS_ROOT = Path(os.getenv("RESULTS_DIR", "/results"))
METRICS_URL = os.getenv("METRICS_URL", "http://metrics:8090/metrics")
METRICS_INTERVAL = max(0.5, float(os.getenv("METRICS_INTERVAL", "2")))
TEST_SCRIPT = os.getenv("K6_SCRIPT", "/opt/loadtest/test.js")


def target_url():
    return os.getenv("TARGET_URL", "")
