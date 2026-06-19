FROM grafana/k6:latest AS k6

FROM python:3.13-alpine

COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY loadtest/run.py /opt/loadtest/run.py
COPY loadtest/test.js /opt/loadtest/test.js

RUN mkdir -p /results

ENTRYPOINT ["python", "/opt/loadtest/run.py"]
