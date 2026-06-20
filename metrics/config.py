import os
import re
from datetime import timedelta, timezone

DOCKER_SOCKET = os.getenv("DOCKER_SOCKET", "/var/run/docker.sock")
PROJECT_NAME = os.getenv("PROJECT_NAME", "qiita_elastic_app")
PORT = int(os.getenv("PORT", "8090"))
HOST_HOSTNAME_FILE = os.getenv("HOST_HOSTNAME_FILE", "/host/etc-hostname")
JST = timezone(timedelta(hours=9))
LOG_TAIL_DEFAULT = 200
LOG_TAIL_MAX = 1000
LOG_FULL_DAY_MAX = 20000
DATE_PARAM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
