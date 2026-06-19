import unittest

from main import cpu_percent, memory_values


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


if __name__ == "__main__":
    unittest.main()
