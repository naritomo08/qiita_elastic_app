import os
import socket
from datetime import timedelta, timezone


DOCKER_SOCKET = os.getenv("DOCKER_SOCKET", "/var/run/docker.sock")
PROJECT_NAME = os.getenv("PROJECT_NAME", "qiita_elastic_app")
PORT = int(os.getenv("PORT", "8090"))
HOST_HOSTNAME_FILE = os.getenv("HOST_HOSTNAME_FILE", "/host/etc-hostname")
ACCESS_LOG_DIR = os.getenv("ACCESS_LOG_DIR", "/var/log/qiita-access")
JST = timezone(timedelta(hours=9))
LOG_TAIL_DEFAULT = 200
LOG_TAIL_MAX = 1000


def read_host_hostname():
    """Return the Docker host hostname, falling back to the container hostname."""
    try:
        with open(HOST_HOSTNAME_FILE, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return socket.gethostname()


HOST_HOSTNAME = read_host_hostname()
