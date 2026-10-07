import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('check_usage', Path(__file__).with_name('check_usage.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UsageTest(unittest.TestCase):
    def test_explicit_permission(self):
        self.assertTrue(module.usage_allowed({'ordinaryUsageAllowed': True}))

    def test_missing_permission_does_not_infer_reset(self):
        self.assertFalse(module.usage_allowed({'rateLimits': {'primary': {'usedPercent': 0, 'resetsAt': 1}}}))

    def test_exhausted(self):
        self.assertFalse(module.usage_allowed({'ordinaryUsageAllowed': False, 'rateLimits': {'credits': {'hasCredits': False}}}))

    def test_available_credits(self):
        self.assertTrue(module.usage_allowed({'ordinaryUsageAllowed': False, 'rateLimits': {'credits': {'hasCredits': True}}}))

    def test_spend_controls_override_credits(self):
        self.assertFalse(module.usage_allowed({'ordinaryUsageAllowed': True, 'rateLimits': {'spendControlReached': True, 'credits': {'hasCredits': True}}}))

    def test_completed_work_does_not_contact_service(self):
        self.assertEqual(module.run({'enabled': True, 'work': []}), 'no runnable unfinished work')

    def test_disabled(self):
        self.assertEqual(module.run({'enabled': False}), 'disabled')


if __name__ == '__main__':
    unittest.main()
