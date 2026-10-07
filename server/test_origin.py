import unittest

from origin import is_extension_allowed


class OriginAllowlistTests(unittest.TestCase):
    def test_empty_allowlist_denies_extensions(self):
        self.assertFalse(is_extension_allowed("chrome-extension://abc", [], False))

    def test_only_listed_extension_is_allowed(self):
        self.assertTrue(is_extension_allowed("chrome-extension://abc/", ["abc"], False))
        self.assertFalse(is_extension_allowed("chrome-extension://other", ["abc"], False))

    def test_allow_any_origin_is_explicit_override(self):
        self.assertTrue(is_extension_allowed("https://example.org", [], True))


if __name__ == "__main__":
    unittest.main()
