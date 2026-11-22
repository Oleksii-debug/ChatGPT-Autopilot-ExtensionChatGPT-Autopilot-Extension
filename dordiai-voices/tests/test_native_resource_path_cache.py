"""Pure Path spelling reuse; every filesystem check stays live and ordered."""
import ast
import importlib.util
from pathlib import Path, PosixPath, WindowsPath, PureWindowsPath
import shutil
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "source/0.12.2/kx47Runtime/native_membership_runtime.py"
CANDIDATE = ROOT / "experiments/native-resource-path-cache/native_membership_runtime.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


baseline = load("resource_path_cache_baseline_test", BASE)
candidate = load("resource_path_cache_candidate_test", CANDIDATE)


class PathSpellingCacheTests(unittest.TestCase):
    def setUp(self):
        candidate._plain_path_ancestry.cache_clear()

    def test_resource_lifecycle_and_every_other_definition_ast_are_identical(self):
        original = ast.parse(BASE.read_text(encoding="utf-8"))
        changed = ast.parse(CANDIDATE.read_text(encoding="utf-8"))
        names = {n.name for n in original.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
        for name in names - {"_signature"}:
            a = next(n for n in original.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == name)
            b = next(n for n in changed.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == name)
            self.assertEqual(ast.dump(a, include_attributes=False), ast.dump(b, include_attributes=False), name)
        self.assertEqual(candidate._plain_path_ancestry.cache_info().maxsize, 16)

    def trace(self, module, path, scenario):
        calls = []
        ancestors = (path, *path.parents)
        bad = str(ancestors[1])
        def symlink(p):
            calls.append(("symlink", str(p)))
            return scenario == "link-parent" and str(p) == bad
        def junction(p):
            calls.append(("junction", str(p)))
            return scenario == "junction-parent" and str(p) == bad
        def query(p, *args, **kwargs):
            calls.append(("stat", str(p)))
            if scenario == "absent":
                raise FileNotFoundError(str(p))
            if scenario == "denied":
                raise PermissionError(str(p))
            return SimpleNamespace(st_mode=stat.S_IFDIR if scenario == "directory" else stat.S_IFREG,
                st_dev=1, st_ino=2, st_size=558, st_mtime_ns=3, st_ctime_ns=4)
        cls = type(path)
        with patch.object(cls, "is_symlink", symlink), patch.object(cls, "is_junction", junction, create=True), \
                patch.object(cls, "stat", query):
            try:
                value = module._signature(path)
                result = ("returned", value)
            except Exception as error:
                result = ("raised", type(error).__name__, str(error))
        return result, calls

    def test_cold_and_hot_signature_have_identical_live_checks_order_and_errors(self):
        path = Path("/owned/long/data/WordLanguage/native-word-membership.json")
        for scenario in ("ordinary", "absent", "directory", "link-parent", "junction-parent", "denied"):
            for repeat in range(2):
                with self.subTest(scenario=scenario, repeat=repeat):
                    self.assertEqual(self.trace(baseline, path, scenario), self.trace(candidate, path, scenario))

    def test_warm_spelling_never_caches_a_file_or_ancestor_fact(self):
        path = Path("/owned/data/WordLanguage/native-word-membership.json")
        self.assertEqual(self.trace(candidate, path, "ordinary")[0][0], "returned")
        for scenario in ("link-parent", "junction-parent", "absent", "directory", "denied", "ordinary"):
            self.assertEqual(self.trace(baseline, path, scenario), self.trace(candidate, path, scenario))
        self.assertGreater(candidate._plain_path_ancestry.cache_info().hits, 0)

    def test_path_subclasses_keep_dynamic_parents_behavior_without_shared_cache(self):
        parent_type = WindowsPath if __import__("os").name == "nt" else PosixPath
        class DynamicPath(parent_type):
            reads = 0
            @property
            def parents(self):
                type(self).reads += 1
                return super().parents
        path = DynamicPath("/owned/data/file")
        for _ in range(2):
            candidate._signature(path)
        self.assertEqual(DynamicPath.reads, 2)
        self.assertEqual(candidate._plain_path_ancestry.cache_info().currsize, 0)

    def test_live_symlink_created_after_cache_warmup_is_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            parent = root / "folder"
            parent.mkdir()
            path = parent / "file"
            path.write_bytes(b"trusted")
            self.assertEqual(candidate._signature(path), baseline._signature(path))
            path.unlink()
            parent.rmdir()
            target = root / "elsewhere"
            target.mkdir()
            (target / "file").write_bytes(b"trusted")
            try:
                parent.symlink_to(target, target_is_directory=True)
            except OSError as error:
                self.skipTest(str(error))
            for module in (baseline, candidate):
                with self.assertRaises(module.NativeMembershipResourceError):
                    module._signature(path)

    def test_cache_bound_and_eviction_leave_checks_live(self):
        for number in range(40):
            candidate._signature(Path("/owned/absent/") / str(number))
        self.assertEqual(candidate._plain_path_ancestry.cache_info().currsize, 16)
        path = Path("/owned/absent/0")
        self.assertEqual(self.trace(baseline, path, "junction-parent"), self.trace(candidate, path, "junction-parent"))

    def test_windows_casefold_path_equality_never_aliases_exact_spelling(self):
        upper = PureWindowsPath("C:/Owned/Case/File.json")
        lower = PureWindowsPath("C:/Owned/case/File.json")
        self.assertEqual(upper, lower)  # This equality must not be a cache key.
        a = candidate._plain_path_ancestry(PureWindowsPath, str(upper))
        b = candidate._plain_path_ancestry(PureWindowsPath, str(lower))
        self.assertEqual(str(a[0]), str(upper))
        self.assertEqual(str(b[0]), str(lower))
        self.assertNotEqual(str(a[0]), str(b[0]))
        self.assertEqual(candidate._plain_path_ancestry.cache_info().currsize, 2)

    def test_length_and_depth_overflow_keep_uncached_live_check_order(self):
        ordinary = Path("/owned/data/file")
        self.trace(candidate, ordinary, "ordinary")
        retained = candidate._plain_path_ancestry.cache_info().currsize
        long_path = Path("/owned") / ("x" * 1025) / "file"
        deep_path = Path("/owned").joinpath(*("a" for _ in range(65)), "file")
        self.assertGreater(len(str(long_path)), 1024)
        self.assertGreater(len(deep_path.parts), 64)
        for path in (long_path, deep_path):
            for scenario in ("ordinary", "absent", "link-parent", "junction-parent", "denied"):
                for _ in range(2):
                    self.assertEqual(self.trace(baseline, path, scenario), self.trace(candidate, path, scenario))
                    self.assertEqual(candidate._plain_path_ancestry.cache_info().currsize, retained)

    def test_cache_eligibility_exact_boundary_is_bounded(self):
        # Prefix is exactly1024 Unicode characters on either platform.
        path = Path("/") / ("x" * 1023)
        self.assertEqual(len(str(path)), 1024)
        self.trace(candidate, path, "ordinary")
        self.assertEqual(candidate._plain_path_ancestry.cache_info().currsize, 1)
        above = Path("/") / ("x" * 1024)
        self.trace(candidate, above, "ordinary")
        self.assertEqual(candidate._plain_path_ancestry.cache_info().currsize, 1)


integration = load("resource_path_cache_original_integration_test", ROOT / "tests/test_native_membership_integration.py")


class CandidateOwnedResourceTests(integration.OwnedResourceTests):
    def setUp(self):
        # Stage the candidate beside unchanged authentic helper modules, just as
        # an owned external installation does; do not patch production methods.
        self.staging = tempfile.TemporaryDirectory()
        self.addCleanup(self.staging.cleanup)
        folder = Path(self.staging.name)
        shutil.copyfile(CANDIDATE, folder / "native_membership_runtime.py")
        for name in ("host_paths.py", "windows_runtime.py"):
            shutil.copyfile(BASE.with_name(name), folder / name)
        own = load("resource_path_cache_lifecycle_" + str(id(self)), folder / "native_membership_runtime.py")
        replacement = patch.object(integration, "manager", own)
        replacement.start()
        self.addCleanup(replacement.stop)
        super().setUp()


if __name__ == "__main__":
    unittest.main()
