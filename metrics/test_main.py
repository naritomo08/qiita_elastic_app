import unittest
from datetime import datetime, timedelta

from main import (
    JST,
    LOG_TAIL_DEFAULT,
    LOG_TAIL_MAX,
    container_display_name,
    cpu_percent,
    day_bounds_jst,
    demux_docker_log_stream,
    enrich_log_entry,
    memory_values,
    parse_access_log_entry,
    parse_date_param,
    parse_tail,
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

    def test_day_bounds_jst_defaults_to_today_midnight_to_midnight(self):
        since, until = day_bounds_jst(None)
        since_jst = datetime.fromtimestamp(since, JST)
        until_jst = datetime.fromtimestamp(until, JST)
        self.assertEqual((since_jst.hour, since_jst.minute, since_jst.second), (0, 0, 0))
        self.assertEqual(since_jst.date(), datetime.now(JST).date())
        self.assertEqual(until_jst - since_jst, timedelta(days=1))

    def test_day_bounds_jst_covers_exactly_the_given_date(self):
        since, until = day_bounds_jst("2026-06-15")
        self.assertEqual(datetime.fromtimestamp(since, JST).isoformat(), "2026-06-15T00:00:00+09:00")
        self.assertEqual(datetime.fromtimestamp(until, JST).isoformat(), "2026-06-16T00:00:00+09:00")

    def test_parse_date_param_accepts_none_or_empty_as_unspecified(self):
        self.assertIsNone(parse_date_param(None))
        self.assertIsNone(parse_date_param(""))

    def test_parse_date_param_accepts_valid_date(self):
        self.assertEqual(parse_date_param("2026-06-20"), "2026-06-20")

    def test_parse_date_param_rejects_malformed_or_invalid_dates(self):
        for value in ("abc", "2026/06/20", "2026-13-99", "2026-02-30"):
            with self.assertRaises(ValueError):
                parse_date_param(value)

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
