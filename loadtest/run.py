import os
import signal
import subprocess
import sys
import threading
from datetime import datetime

from config import JST, METRICS_INTERVAL, RESULTS_ROOT, TEST_SCRIPT, target_url
from metrics_collector import collect_metrics
from report import timestamp, write_report


# Bind mount 上の生成物をホスト側ユーザーから削除できるようにする。
os.umask(0o000)


def main():
    if not target_url():
        print("ERROR: TARGET_URL is required.", file=sys.stderr)
        return 2

    result_dir = create_result_dir()
    samples = []
    metric_errors = []
    stop_event = threading.Event()
    collector = threading.Thread(
        target=collect_metrics,
        args=(
            stop_event,
            result_dir / "container-metrics.csv",
            samples,
            metric_errors,
        ),
        daemon=True,
    )
    collector.start()

    command = [
        "k6",
        "run",
        "--summary-export",
        str(result_dir / "k6-summary.json"),
        TEST_SCRIPT,
    ]
    started_at = timestamp()
    print(f"Results: {result_dir}")
    print(f"Running: {' '.join(command)}")

    try:
        exit_code = run_k6(command, result_dir / "k6-output.txt")
    finally:
        stop_event.set()
        collector.join(timeout=METRICS_INTERVAL + 6)

    write_report(
        result_dir,
        started_at,
        timestamp(),
        exit_code,
        samples,
        metric_errors,
    )
    print(f"Summary: {result_dir / 'summary.txt'}")
    return exit_code


def create_result_dir():
    run_id = datetime.now(JST).strftime("%Y%m%d-%H%M%S-%f")
    result_dir = RESULTS_ROOT / run_id
    result_dir.mkdir(parents=True, exist_ok=False)
    return result_dir


def run_k6(command, output_path):
    process = None

    def forward_signal(signum, _frame):
        if process and process.poll() is None:
            process.send_signal(signum)

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        with output_path.open("w", encoding="utf-8") as output:
            for line in process.stdout:
                print(line, end="")
                output.write(line)
        return process.wait()
    except OSError as error:
        output_path.write_text(f"{error}\n", encoding="utf-8")
        print(f"ERROR: {error}", file=sys.stderr)
        return 127


if __name__ == "__main__":
    raise SystemExit(main())
