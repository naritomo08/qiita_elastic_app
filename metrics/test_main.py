import unittest
from datetime import datetime

from main import (
    JST,
    LOG_TAIL_DEFAULT,
    LOG_TAIL_MAX,
    container_display_name,
    cpu_percent,
    demux_docker_log_stream,
    enrich_log_entry,
    memory_values,
    parse_access_log_entry,
    parse_tail,
    start_of_today_jst_epoch,
    today_jst_date,
)


class MetricsTest(unittest.TestCase):
    def test_cpu_percent_uses_online_cpu_count(self):
        stats = {
            "cpu_stats": {
                "cpu_usage": {"total_usage": 300},
                "system_cpu_usage": 1000,
                "online_cpus": 2,
            },
            "precpu_stats": {
                "cpu_usage": {"total_usage": 200},
                "system_cpu_usage": 600,
            },
        }
        self.assertEqual(cpu_percent(stats), 50.0)

    def test_memory_values_exclude_inactive_file_cache(self):
        usage, limit, percent = memory_values(
            {
                "memory_stats": {
                    "usage": 600,
                    "limit": 1000,
                    "stats": {"total_inactive_file": 100},
                }
            }
        )
        self.assertEqual((usage, limit, percent), (500, 1000, 50.0))

    def test_demux_docker_log_stream_strips_frame_headers(self):
        def frame(stream_type, payload):
            header = bytes([stream_type, 0, 0, 0]) + len(payload).to_bytes(4, "big")
            return header + payload

        data = frame(1, b"hello stdout\n") + frame(2, b"oops stderr\n")
        self.assertEqual(demux_docker_log_stream(data), ["hello stdout", "oops stderr"])

    def test_demux_docker_log_stream_handles_empty_input(self):
        self.assertEqual(demux_docker_log_stream(b""), [])

    def test_parse_tail_defaults_on_missing_or_invalid_value(self):
        self.assertEqual(parse_tail(None), LOG_TAIL_DEFAULT)
        self.assertEqual(parse_tail("not-a-number"), LOG_TAIL_DEFAULT)

    def test_parse_tail_clamps_to_maximum(self):
        self.assertEqual(parse_tail(str(LOG_TAIL_MAX + 500)), LOG_TAIL_MAX)
        self.assertEqual(parse_tail("50"), 50)

    def test_start_of_today_jst_epoch_is_midnight_jst_of_today(self):
        epoch = start_of_today_jst_epoch()
        at_jst = datetime.fromtimestamp(epoch, JST)
        self.assertEqual((at_jst.hour, at_jst.minute, at_jst.second), (0, 0, 0))
        self.assertEqual(at_jst.date(), datetime.now(JST).date())

    def test_parse_access_log_entry_strips_docker_timestamp_prefix(self):
        line = '2026-06-20T12:48:12.614625716Z {"status": 200, "uri": "/"}'
        self.assertEqual(parse_access_log_entry(line), {"status": 200, "uri": "/"})

    def test_parse_access_log_entry_returns_none_for_invalid_json(self):
        self.assertIsNone(parse_access_log_entry("not json at all"))

    def test_today_jst_date_is_todays_date_in_jst(self):
        self.assertEqual(today_jst_date(), datetime.now(JST).date().isoformat())

    def test_container_display_name_strips_leading_slash(self):
        self.assertEqual(
            container_display_name({"Id": "abc123", "Names": ["/qiita-search-frontend"]}),
            "qiita-search-frontend",
        )

    def test_container_display_name_falls_back_to_short_id(self):
        self.assertEqual(
            container_display_name({"Id": "abcdef0123456789", "Names": []}),
            "abcdef012345",
        )

    def test_enrich_log_entry_renames_time_and_adds_metadata(self):
        entry = {
            "time": "2026-06-20T13:11:05+00:00",
            "remote_addr": "192.168.11.128",
            "method": "GET",
            "uri": "/favicon.ico",
            "status": 200,
        }
        enriched = enrich_log_entry(entry, "frontend", "elastic1", "qiita-search-frontend")
        self.assertEqual(
            enriched,
            {
                "@timestamp": "2026-06-20T13:11:05+00:00",
                "dt": "2026-06-20",
                "service": "frontend",
                "host": "elastic1",
                "container": "qiita-search-frontend",
                "remote_addr": "192.168.11.128",
                "method": "GET",
                "uri": "/favicon.ico",
                "status": 200,
            },
        )
        self.assertEqual(list(enriched.keys())[:5], ["@timestamp", "dt", "service", "host", "container"])

    def test_enrich_log_entry_handles_missing_time(self):
        enriched = enrich_log_entry({"status": 200}, "frontend", "elastic1", "frontend")
        self.assertIsNone(enriched["@timestamp"])
        self.assertIsNone(enriched["dt"])


if __name__ == "__main__":
    unittest.main()
