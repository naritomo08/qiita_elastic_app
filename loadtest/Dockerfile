FROM grafana/k6:latest AS k6

FROM python:3.13-alpine

COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY loadtest/*.py loadtest/test.js /opt/loadtest/

RUN mkdir -p /results

ENTRYPOINT ["python", "/opt/loadtest/run.py"]
